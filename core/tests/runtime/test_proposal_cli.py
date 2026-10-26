"""합성 문장·가짜 Codex 실행파일·실제 loopback 서버로 후보 경계를 검증한다."""

import asyncio
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
from uuid import uuid4

from core.paths import PROJECT_DIR
from core.modules.analysis_results import diagnostics
from core.modules.ontology.store import OntologyStore
from core.modules.reviews.store import ReviewStore
from core.tests.runtime import test_fixed_input_cli as fixed_fixture
from core.tests.runtime import test_personal_ai_workflow as runner_fixture


@unittest.skipUnless(os.name == "posix", "Synthetic executable uses a POSIX shebang; not Windows verification.")
class ProposalCliTests(unittest.IsolatedAsyncioTestCase):
    save_policy = fixed_fixture.FixedInputCliTests.save_policy
    server = runner_fixture.PersonalAIWorkflowTests.server

    def setUp(self):
        fixed_fixture.FixedInputCliTests.setUp(self)
        self.config["users"]["alice"]["memberships"]["alpha"]["permissions"] = ["read", "source_write", "ontology_write", "write"]
        self.save_policy()
        self.store = self.stores["alpha"]
        saved = self.store.save("target.md", runner_fixture.SOURCE, expected_revision=None)
        OntologyStore(self.store).generate("target.md", saved.revision, **runner_fixture.GRAPH)
        self.token_path = self.root.resolve() / "proposal.token"
        self.token_path.write_text(self.tokens["alice"])
        self.token_path.chmod(0o600)
        self.work = self.root.resolve() / "proposal-work"

    def canonical(self):
        paths = [self.store.wiki_dir, self.store.history_dir, self.store.data_dir / "_ontology", self.store.data_dir / "_reviews"]
        return {str(p): p.read_bytes() for root in paths if root.exists() for p in root.rglob("*") if p.is_file()}

    async def proposal(self, http):
        current = ReviewStore(self.store).query("target.md")
        response = await http.post(self.base + "/analysis-proposals", json={"request_id": uuid4().hex,
            "document": "target.md", "expected_source_revision": current["source_revision"],
            "expected_state_revision": current["state_revision"]})
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()["data"]

    def fake_cli(self, *, delay=0.2, fail_semantic=False):
        executable = runner_fixture.PersonalAIWorkflowTests.fake_cli(self, False)
        assessment = {key: value for key, value in diagnostics.empty_report().items()
                      if key not in {"schema_version", "reviewer_kind", "findings"}}
        assessment["rule_results"] = {rule: {"status": "not_run", "reason": "합성 실행 계약만 확인", "findings": []}
                                      for rule in diagnostics.SEMANTIC_RULES}
        text = executable.read_text().replace("import json,sys", "import json,sys,os,time")
        text = text.replace("result = wiki if wiki_stage else graph\n", "result = wiki if wiki_stage else graph\n"
            "assert 'LLM_WIKI_TOKEN' not in os.environ and 'OPENAI_API_KEY' not in os.environ\n"
            "Path('fixture.pid').write_text(str(os.getpid()))\n"
            "print(json.dumps({'type':'item.updated','item':{'type':'agent_message','text':'{\"submission\":'}}),flush=True)\n"
            f"time.sleep({delay})\n"
            "if '제출 그래프를 보기 전에' in prompt:\n result = {'audit':'합성 원문의 모델과 센서 관계를 확인한다.'}\n"
            f"elif '먼저 고정한 audit와 원문' in prompt:\n result = json.loads({json.dumps(json.dumps(assessment, ensure_ascii=False))})\n"
            + ("if '제출 그래프를 보기 전에' in prompt: raise SystemExit(1)\n" if fail_semantic else ""))
        executable.write_text(text)
        return executable

    async def invoke(self, url, proposal, *, semantic=False, cancel=None, extra=(), delay=0.2):
        executable = self.fake_cli(delay=delay)
        command = [sys.executable, "-B", "-m", "tools.proposal_cli", "--server", url, "--tenant", "alpha", "--profile", "all",
            "--proposal-id", proposal["proposal_id"], "--token-file", str(self.token_path), "--work-dir", str(self.work),
            "--ai-cli", str(executable), "--ai-provider", getattr(self, "provider", "codex"), "--ai-timeout", "15", *extra]
        if not extra:
            command += ["--run-ai", "--expected-proposal-revision", proposal["state_revision"]]
        if semantic:
            command += ["--semantic-check"]
        process = await asyncio.create_subprocess_exec(*command, cwd=PROJECT_DIR, stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        events = []
        try:
            while line := await asyncio.wait_for(process.stdout.readline(), 30):
                self.assertNotIn(self.tokens["alice"].encode(), line)
                event = json.loads(line)
                self.assertEqual(event["protocol"], "proposal-cli-v1")
                events.append(event)
                if event["type"] == "candidate_preview" and cancel:
                    if cancel == "stdin":
                        process.stdin.write(b'{"type":"cancel"}\n')
                        await process.stdin.drain()
                    else:
                        process.terminate()
                    cancel = None
            await asyncio.wait_for(process.wait(), 15)
            stderr = await process.stderr.read()
            self.assertEqual(stderr, b"")
            self.assertEqual(sum(e["type"] == "result" for e in events), 1)
            return events[-1], events, process.returncode
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()

    async def test_real_cli_candidate_semantic_and_read_only_resume_preserve_canonical(self):
        async with self.server() as (http, url):
            proposal = await self.proposal(http)
            before = self.canonical()
            with patch.dict(os.environ, {"LLM_WIKI_TOKEN": "not-for-model", "OPENAI_API_KEY": "not-for-model"}):
                result, events, code = await self.invoke(url, proposal, semantic=True)
            self.assertEqual(code, 0, result)
            self.assertEqual(result["status"], "candidate_ready", result)
            self.assertTrue(result["candidate_saved"], result)
            self.assertTrue(result["diagnostics_saved"], result)
            self.assertFalse(result["canonical_saved"])
            self.assertFalse(result["human_approval"])
            execution = json.loads((Path(result["work_dir"]) / "invocation/execution.json").read_text())
            self.assertEqual(execution["provider"], getattr(self, "provider", "codex"))
            self.assertEqual(self.canonical(), before)
            view = (await http.get(self.base + "/analysis-proposals/" + proposal["proposal_id"])).json()["data"]
            self.assertEqual(len(view["result_links"]), 2)
            self.assertTrue(any(e["type"] == "candidate_preview" and not e["saved"] for e in events))
            resumed, _, code = await self.invoke(url, proposal, extra=["--resume-dir", result["work_dir"]])
            self.assertEqual(code, 0, resumed)
            self.assertTrue(resumed["candidate_saved"])
            self.assertTrue(resumed["diagnostics_saved"])
            self.assertEqual(self.canonical(), before)
            self.assertEqual(len(list(Path(result["work_dir"]).glob("invocation"))), 1)

    async def test_stdin_and_signal_cancel_reap_child_and_confirm_server(self):
        async with self.server() as (http, url):
            for mode in ("stdin", "signal"):
                proposal = await self.proposal(http)
                before = self.canonical()
                result, _, code = await self.invoke(url, proposal, cancel=mode, delay=10)
                self.assertEqual(code, 130, result)
                self.assertEqual(result["cancellation"], "confirmed", result)
                self.assertFalse(result["candidate_saved"])
                self.assertEqual(self.canonical(), before)
                pid = int((Path(result["work_dir"]) / "invocation/fixture.pid").read_text())
                with self.assertRaises(ProcessLookupError):
                    os.kill(pid, 0)

    async def test_existing_execution_and_exact_receipt_after_write_revocation(self):
        async with self.server() as (http, url):
            proposal = await self.proposal(http)
            execution_id = uuid4().hex
            made = await http.post(self.base + "/analysis-proposals/" + proposal["proposal_id"] + "/executions", json={
                "request_id": execution_id, "expected_state_revision": proposal["state_revision"],
                "candidate_revision": None, "reason": "합성 UI의 명시 재추출", "profile": "all"})
            self.assertEqual(made.status_code, 200, made.text)
            result, _, code = await self.invoke(url, proposal, extra=["--execution-id", execution_id, "--run-ai"])
            self.assertEqual(code, 0, result)
            self.assertEqual(result["execution_id"], execution_id)
            self.config["users"]["alice"]["memberships"]["alpha"]["permissions"] = ["read"]
            self.save_policy()
            receipt, _, code = await self.invoke(url, proposal, extra=["--receipt-request-id", result["link_request_id"]])
            self.assertEqual(code, 0, receipt)
            self.assertEqual(receipt["status"], "receipt")
            self.assertTrue(receipt["candidate_saved"])
            view = (await http.get(self.base + "/analysis-proposals/" + proposal["proposal_id"])).json()["data"]
            self.assertEqual(len(view["executions"]), 1)


if __name__ == "__main__":
    unittest.main()
