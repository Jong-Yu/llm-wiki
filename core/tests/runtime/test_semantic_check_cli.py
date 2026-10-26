"""실제 임시 서버와 CLI 프로세스의 별도 의미 보고 연결. 모델 출력만 합성 fixture다."""

import asyncio
import json
import sys
import unittest
from uuid import uuid4

from core.modules.analysis_results import diagnostics
from core.paths import PROJECT_DIR
from core.tests.runtime import test_personal_ai_workflow as fixture


class SemanticCheckCliTests(unittest.IsolatedAsyncioTestCase):
    setUp = fixture.PersonalAIWorkflowTests.setUp
    save_policy = fixture.PersonalAIWorkflowTests.save_policy
    server = fixture.PersonalAIWorkflowTests.server

    async def test_separate_semantic_report_is_stored_before_graph_without_becoming_approval(self):
        await self.run_case()

    async def test_partial_semantic_report_preserves_raw_and_server_result_refs(self):
        await self.run_case(invalid_quote=True)

    async def run_case(self, invalid_quote=False):
        executable = fixture.PersonalAIWorkflowTests.fake_cli(self, False)
        assessment = {key: value for key, value in diagnostics.empty_report().items()
                      if key not in {"schema_version", "reviewer_kind", "findings"}}
        assessment.update(reviewed_ranges=[{"start_line": 1, "end_line": 1}], rule_results={
            rule: {"status": "pass", "reason": "합성 subprocess 계약 확인", "findings": []}
            for rule in diagnostics.SEMANTIC_RULES})
        if invalid_quote:
            finding = {"verdict": "schema_limit", "source": {"start_line": 1, "end_line": 1,
                "quote": fixture.SOURCE.strip()}, "target": {"collection": "relations", "index": 0},
                "reason": "합성 표현 한계", "recommendation": None, "question": None}
            assessment["rule_results"]["R-S05"].update(status="fail", findings=[finding])
            assessment["rule_results"]["R-S02"].update(status="fail", findings=[{
                **finding, "source": {**finding["source"], "quote": "원문에 없는 인용"}}])
        script = executable.read_text()
        script = script.replace("result = wiki if wiki_stage else graph\n", "result = wiki if wiki_stage else graph\n"
            "if '제출 그래프를 보기 전에' in prompt:\n result = {'audit': '원문 첫 줄의 모델과 센서 관계를 확인한다.'}\n"
            f"elif '먼저 고정한 audit와 원문' in prompt:\n result = json.loads({json.dumps(json.dumps(assessment, ensure_ascii=False))})\n")
        executable.write_text(script)
        async with self.server() as (http, url):
            response = await http.post(self.base + "/sources", json={"request_id": uuid4().hex,
                "title": "별도 검사 합성 원본", "format": "txt", "content": fixture.SOURCE})
            self.assertEqual(response.status_code, 201)
            source = response.json()["data"]
            response = await http.post(self.base + "/analysis-jobs", json={"request_id": uuid4().hex,
                "source_id": source["source_id"], "source_version": source["source_version"],
                "source_sha256": source["source_sha256"], "expected_registration_revision": source["registration_revision"],
                "targets": ["target.md"], "outputs": ["wiki", "ontology"]})
            self.assertEqual(response.status_code, 201)
            job_id = response.json()["data"]["job_id"]
            token_file = self.root / "semantic-cli.token"
            token_file.write_text(self.tokens["alice"])
            token_file.chmod(0o600)
            work = self.root.resolve() / "work"
            cli = await asyncio.create_subprocess_exec(sys.executable, "-B", "-m", "tools.analysis_cli",
                "--server", url, "--tenant", "alpha", "--job-id", job_id, "--token-file", str(token_file),
                "--work-dir", str(work), "--run-ai", "--semantic-check", "--ai-cli", str(executable),
                "--ai-provider", getattr(self, "provider", "codex"),
                "--ai-timeout", "10", cwd=PROJECT_DIR,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            stdout, stderr = await asyncio.wait_for(cli.communicate(), timeout=30)
            self.assertEqual(cli.returncode, 0, stderr.decode())
            self.assertNotIn(self.tokens["alice"].encode(), stdout + stderr)
            job = (await http.get(self.base + "/analysis-jobs/" + job_id)).json()["data"]
            self.assertEqual(job["result_summary"]["status"], "complete")
            self.assertEqual(job["result_summary"]["saved_count"], 2)
            self.assertEqual(len(job["result_summary"]["results"]), 3)
            draft = next(row for row in job["result_summary"]["results"] if row["state"] == "draft")
            report = (await http.get(self.base + f"/analysis-jobs/{job_id}/results/{draft['request_id']}")).json()["data"]
            self.assertFalse(report["saved"])
            self.assertFalse(report["diagnostics"]["human_approval"])
            expected_statuses = {"pass", "fail", "error"} if invalid_quote else {"pass"}
            self.assertEqual({r["status"] for r in report["diagnostics"]["semantic"]["rule_results"]}, expected_statuses)
            directory = work / job_id / job["run_id"] / "extract_ontology"
            local = json.loads((directory / "semantic-check/diagnostics.json").read_text())
            self.assertEqual(report["diagnostics"]["report"], local)
            for name in ("source_audit_execution", "assessment_execution"):
                self.assertEqual(local["semantic_check"][name]["provider"], getattr(self, "provider", "codex"))
            self.assertEqual(local["semantic_check"]["input"]["submission_sha256"], report["diagnostics"]["basis"]["submission_hash"])
            self.assertTrue((directory / "generation-diagnostics.json").is_file())
            self.assertTrue((directory / "semantic-check/source-audit.json").is_file())
            self.assertEqual(report["diagnostics"]["report_id"], draft["request_id"])
            raw_path = directory / "semantic-check/assessment/result.json"
            self.assertEqual(json.loads(raw_path.read_text()), assessment)
            if invalid_quote:
                self.assertEqual(local["rule_results"][1]["status"], "error")
                self.assertEqual(local["rule_results"][4]["status"], "fail")
                self.assertEqual(local["rule_results"][4]["finding_indices"], [0])
                self.assertEqual(local["findings"][0]["source"]["quote"], fixture.SOURCE.strip())
                failure = json.loads((directory / "semantic-check/failure.json").read_text())
                self.assertEqual(failure["preservation"], "validated_partial_report")
                self.assertEqual(failure["raw_assessment"], "assessment/result.json")
            self.assertEqual(len([p for p in (self.stores["alpha"].history_dir / "target.md").glob("*.md") if p.is_file()]), 1)


if __name__ == "__main__":
    unittest.main()
