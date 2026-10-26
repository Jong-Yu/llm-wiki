"""가짜 개인 AI와 실제 서버/CLI로 저장 완료·부분 실패 두 흐름만 확인한다."""

import asyncio
from contextlib import asynccontextmanager
from hashlib import sha256
import json
from pathlib import Path
import socket
import sys
import time
import unittest
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import httpx2

from core.client.ai.lease import LeaseKeeper
from core.client.transport import AnalysisClientError
from core.modules.ontology.store import OntologyStore
from core.modules.analysis_results.diagnostics import empty_report
from core.paths import PROJECT_DIR
from core.tests.runtime import test_fixed_input_cli as fixture


SOURCE = "모델은 센서를 사용한다.\n"
GRAPH = {"schema_version": 3, "entities": [
    {"id": "model", "type": "system", "label": "모델", "evidence": "모델",
     "context": {"domain": None, "viewpoints": []}, "identifiers": []},
    {"id": "sensor", "type": "physical_object", "label": "센서", "evidence": "센서",
     "context": {"domain": None, "viewpoints": []}, "identifiers": []}],
    "relations": [{"subject": "model", "predicate": "uses", "object": "sensor", "evidence": SOURCE.strip(),
        "context": {"domain": None, "viewpoints": []},
        "provenance": {"source_entity": None, "attributed_to": None, "basis": None},
        "qualifiers": {"polarity": "positive", "modality": "asserted", "condition": None, "scope": None, "time": None}}],
    "relation_candidates": [], "attributes": []}


class PersonalAIWorkflowTests(unittest.IsolatedAsyncioTestCase):
    save_policy = fixture.FixedInputCliTests.save_policy

    def setUp(self):
        # 기존 실제 서버 fixture를 재사용하되 기존 검사 메서드를 상속해 중복 실행하지 않는다.
        fixture.FixedInputCliTests.setUp(self)
        self.config["users"]["alice"]["memberships"]["alpha"]["permissions"] = [
            "read", "source_write", "write", "ontology_write"]
        self.save_policy()
        self.old_content = "수정 전 전체 위키 본문\n"
        self.stores["alpha"].save("target.md", self.old_content, expected_revision=None)

    def fake_cli(self, fail_graph):
        path = self.root.resolve() / ("fail-graph" if fail_graph else "fake-codex")
        wiki = {"content": SOURCE, "diagnostics": {**empty_report(), "warnings": ["합성 실행 보고"]}}
        body = f"#!{Path(sys.executable).resolve()}\nimport json,sys\nfrom pathlib import Path\n"
        body += "if '--version' in sys.argv:\n print('codex-test 1.0'); raise SystemExit(0)\n"
        body += "if '--help' in sys.argv:\n print('--ephemeral --ignore-user-config --output-schema --output-last-message --json --sandbox --skip-git-repo-check --disable --enable'); raise SystemExit(0)\n"
        # 결과는 합성 fixture다. 모델의 의미 추출 정확도나 실제 로그인을 검증한 것으로 세지 않는다.
        body += "prompt = sys.stdin.read()\nwiki_stage = '작업 단계: prepare_wiki' in prompt\n"
        body += "if not wiki_stage and Path(sys.argv[0]).name == 'fail-graph':\n print(json.dumps({'type':'turn.failed'})); raise SystemExit(0)\n"
        body += f"wiki = json.loads({json.dumps(json.dumps(wiki, ensure_ascii=False))})\n"
        body += f"graph = json.loads({json.dumps(json.dumps({"submission": GRAPH, "diagnostics": empty_report()}, ensure_ascii=False))})\n"
        body += "result = wiki if wiki_stage else graph\n"
        body += "Path(sys.argv[sys.argv.index('--output-last-message')+1]).write_text(json.dumps(result,ensure_ascii=False),encoding='utf-8')\n"
        body += "print(json.dumps({'type':'thread.started','thread_id':'synthetic'}))\nprint(json.dumps({'type':'turn.started'}))\n"
        body += "print(json.dumps({'type':'item.completed','item':{'type':'agent_message'}}))\nprint(json.dumps({'type':'turn.completed'}))\n"
        path.write_text(body, encoding="utf-8")
        path.chmod(0o700)
        if getattr(self, "provider", "codex") == "claude":
            from core.tests.runtime.claude_fixture import as_claude
            as_claude(path)
        return path

    @asynccontextmanager
    async def server(self):
        # 임시 loopback 포트만 연다. 실행 중인 사용자 서버를 재시작하거나 종료하지 않는다.
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        process = await asyncio.create_subprocess_exec(sys.executable, "-B", "-m", "core.runtime.http_cli",
            "--access-config", str(self.config_path), "--tenant-root", str(self.tenant_root), "--port", str(port),
            *self.server_arguments, cwd=PROJECT_DIR, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            async with httpx2.AsyncClient(base_url=f"http://127.0.0.1:{port}",
                    headers={"Authorization": "Bearer " + self.tokens["alice"]}, trust_env=False, timeout=10) as http:
                deadline = time.monotonic() + 10
                while True:
                    try:
                        if (await http.get("/api/v1/access-context")).status_code == 200:
                            break
                    except httpx2.TransportError:
                        pass
                    if process.returncode is not None or time.monotonic() > deadline:
                        self.fail("Isolated API/MCP server did not start")
                    await asyncio.sleep(0.05)
                yield http, f"http://127.0.0.1:{port}"
        finally:
            if process.returncode is None:
                process.terminate()
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=10)
            self.assertEqual(stdout, b"")
            self.assertNotIn(self.tokens["alice"].encode(), stderr)

    async def run_cli(self, http, url, *, fail_graph):
        source_response = await http.post(self.base + "/sources", json={"request_id": uuid4().hex,
            "title": "분석 원본", "format": "txt", "content": SOURCE})
        self.assertEqual(source_response.status_code, 201)
        source = source_response.json()["data"]
        response = await http.post(self.base + "/analysis-jobs", json={"request_id": uuid4().hex,
            "source_id": source["source_id"], "source_version": source["source_version"],
            "source_sha256": source["source_sha256"], "expected_registration_revision": source["registration_revision"],
            "targets": ["target.md"], "outputs": ["wiki", "ontology"]})
        self.assertEqual(response.status_code, 201, response.text)
        job_id = response.json()["data"]["job_id"]
        token_file = self.root / "client.token"
        token_file.write_text(self.tokens["alice"], encoding="ascii")
        token_file.chmod(0o600)
        work = self.root.resolve() / "work"
        cli = await asyncio.create_subprocess_exec(sys.executable, "-B", "-m", "tools.analysis_cli",
            "--server", url, "--tenant", "alpha", "--job-id", job_id, "--token-file", str(token_file),
            "--work-dir", str(work), "--run-ai", "--ai-cli", str(self.fake_cli(fail_graph)),
            "--ai-provider", getattr(self, "provider", "codex"),
            "--ai-model", "chosen-model", "--ai-timeout", "10", cwd=PROJECT_DIR,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        stdout, stderr = await asyncio.wait_for(cli.communicate(), timeout=20)
        self.assertNotIn(self.tokens["alice"].encode(), stdout + stderr)
        current = (await http.get(self.base + "/analysis-jobs/" + job_id)).json()["data"]
        return cli.returncode, stdout, stderr, current, work / job_id / current["run_id"], source

    async def test_actual_cli_stores_wiki_graph_and_client_execution_receipts(self):
        async with self.server() as (http, url):
            code, stdout, stderr, job, directory, source = await self.run_cli(http, url, fail_graph=False)
            self.assertEqual(code, 0, stderr.decode())
            self.assertTrue(json.loads(stdout)["ok"])
            self.assertEqual(job["result_summary"]["status"], "complete")
            self.assertEqual(self.stores["alpha"].read("target.md").content, SOURCE)
            history = list((self.stores["alpha"].history_dir / "target.md").glob("*.md"))
            self.assertEqual(len(history), 1)
            self.assertEqual(history[0].read_text(), self.old_content)
            graph = OntologyStore(self.stores["alpha"]).query("target.md")
            self.assertEqual(graph["graph_revision"], json.loads((directory / "extract_ontology/receipt.json").read_text())["receipt"]["graph_revision"])
            for stage in ("prepare_wiki", "extract_ontology"):
                local = json.loads((directory / stage / "receipt.json").read_text())
                receipt = (await http.get(self.base + f"/analysis-jobs/{job['job_id']}/results/{local['request_id']}")).json()["data"]["receipt"]
                self.assertEqual(receipt["execution"]["origin"], "client_reported")
                self.assertEqual(receipt["execution"]["provider"], getattr(self, "provider", "codex"))
                report = (await http.get(self.base + f"/analysis-jobs/{job['job_id']}/results/{local['request_id']}")).json()["data"]["diagnostics"]
                self.assertFalse(report["human_approval"])
                if stage == "prepare_wiki":
                    self.assertEqual(report["report"]["warnings"], ["합성 실행 보고"])
                prompt = (directory / stage / "invocation/prompt.txt").read_bytes()
                self.assertEqual(receipt["execution"]["prompt_sha256"], sha256(prompt).hexdigest())
                self.assertNotIn(self.tokens["alice"].encode(), prompt)
            self.assertEqual(json.loads((directory / "ai-result.json").read_text())["status"], "stored")
            self.assertEqual((await http.get(self.base + f"/sources/{source['source_id']}/versions/{source['source_version']}/file")).content, SOURCE.encode())

    async def test_graph_failure_preserves_saved_wiki_and_lease_loss_cancels_waiting_work(self):
        async with self.server() as (http, url):
            code, stdout, stderr, job, directory, _ = await self.run_cli(http, url, fail_graph=True)
            self.assertEqual(code, 1)
            self.assertEqual(stdout, b"")
            self.assertEqual(json.loads(stderr)["error"]["code"], "ai_execution_failed")
            self.assertEqual(job["result_summary"]["status"], "partial")
            self.assertEqual(job["result_summary"]["saved_count"], 1)
            self.assertEqual(self.stores["alpha"].read("target.md").content, SOURCE)
            self.assertEqual(len(list((self.stores["alpha"].history_dir / "target.md").glob("*.md"))), 1)
            self.assertFalse(list((self.stores["alpha"].data_dir / "_ontology").glob("*.json")))
            failure = json.loads((directory / "ai-failure.json").read_text())
            self.assertFalse(failure["automatic_retry"])
            self.assertEqual(len(failure["receipts"]), 1)
        # 별도 네트워크 없이 heartbeat 실패가 기다리던 AI 작업을 실제 취소하는지만 확인한다.
        cancelled = asyncio.Event()

        async def waiting():
            try:
                await asyncio.sleep(30)
            finally:
                cancelled.set()

        broken_http = type("BrokenHTTP", (), {"request": AsyncMock(side_effect=OSError("fixture"))})()
        with patch("core.client.ai.lease.HEARTBEAT_SECONDS", 0.01):
            async with LeaseKeeper(broken_http, tenant="alpha", job_id="job", run_id="run", lease_revision="revision") as lease:
                with self.assertRaises(AnalysisClientError) as error:
                    await lease.guard(waiting())
                self.assertEqual(error.exception.code, "analysis_lease_lost")
        self.assertTrue(cancelled.is_set())


if __name__ == "__main__":
    unittest.main()
