"""실제 loopback API/MCP와 합성 CLI로 부분 저장 재개·설정 진단을 검증한다."""
import asyncio
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

from core.paths import PROJECT_DIR
from core.tests.runtime import test_personal_ai_workflow as workflow_fixture
SOURCE = workflow_fixture.SOURCE
from tools.runtime_doctor import connection


class AnalysisResumeTests(unittest.IsolatedAsyncioTestCase):
    setUp=workflow_fixture.PersonalAIWorkflowTests.setUp
    save_policy=workflow_fixture.PersonalAIWorkflowTests.save_policy
    server=workflow_fixture.PersonalAIWorkflowTests.server
    fake_cli=workflow_fixture.PersonalAIWorkflowTests.fake_cli
    run_cli=workflow_fixture.PersonalAIWorkflowTests.run_cli

    async def test_partial_resume_skips_saved_wiki_and_cas_rejects_before_model(self):
        async with self.server() as (http,url):
            code,_,_,job,old_directory,_=await self.run_cli(http,url,fail_graph=True)
            self.assertEqual(code,1)
            token=self.root/'client.token'
            args=[sys.executable,'-B','-m','tools.analysis_cli','--server',url,'--tenant','alpha',
                '--job-id',job['job_id'],'--token-file',str(token),'--work-dir',str(old_directory.parent.parent),
                '--run-ai','--reclaim','--ai-cli',str(self.fake_cli(False)),'--expected-job-revision']
            stale=await asyncio.create_subprocess_exec(*args,'0'*64,cwd=PROJECT_DIR,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
            out,err=await stale.communicate()
            self.assertEqual(json.loads(err)['error']['code'],'analysis_job_changed')
            child=await asyncio.create_subprocess_exec(*args,job['job_revision'],cwd=PROJECT_DIR,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
            out,err=await asyncio.wait_for(child.communicate(),30)
            self.assertEqual(child.returncode,0,err.decode())
            value=json.loads(out)
            directory=old_directory.parent/value['run_id']
            self.assertFalse((directory/'prepare_wiki').exists())
            self.assertFalse((directory/'reading-request.json').exists())
            self.assertTrue((directory/'extract_ontology/receipt.json').is_file())
            self.assertEqual(self.stores['alpha'].read('target.md').content,SOURCE)
            self.assertEqual(len(list((self.stores['alpha'].history_dir/'target.md').glob('*.md'))),1)
            current=(await http.get(self.base+'/analysis-jobs/'+job['job_id'])).json()['data']
            self.assertEqual(current['result_summary']['status'],'complete')
            diagnosis=await connection(url,token,'alpha','all')
            self.assertEqual(diagnosis['api']['status'],'ok')
            self.assertEqual(diagnosis['mcp']['status'],'ok')
            self.assertEqual(diagnosis['comparison']['status'],'ok')
            self.assertEqual(diagnosis['comparison']['backend_identity'],'not_available')

    async def test_separate_check_error_is_retained_as_draft_before_graph_save(self):
        async with self.server() as (http,url):
            original_spawn = asyncio.create_subprocess_exec
            async def spawn(*args, **kwargs):
                if 'tools.analysis_cli' in args:
                    args = (*args, '--semantic-check')
                return await original_spawn(*args, **kwargs)
            with patch.object(asyncio, 'create_subprocess_exec', spawn):
                code,out,err,job,directory,_=await self.run_cli(http,url,fail_graph=False)
            self.assertEqual(code,0,err.decode())
            value=json.loads(out)['ai_execution']
            self.assertEqual(value['semantic_validation'],'client_reported')
            self.assertFalse(value['human_approval'])
            report=value['semantic_reports'][0]
            self.assertEqual(report['state'],'draft')
            self.assertFalse(report['saved'])
            self.assertEqual(report['diagnostics']['report']['reviewer_kind'],'separate_ai')
            self.assertTrue(all(row['status']=='error' for row in report['diagnostics']['report']['rule_results']))
            self.assertNotEqual(report['request_id'],value['receipts'][-1]['request_id'])
            self.assertEqual(job['result_summary']['status'],'complete')
            self.assertTrue((directory/'extract_ontology/generation-diagnostics.json').is_file())



if __name__=='__main__': unittest.main()
