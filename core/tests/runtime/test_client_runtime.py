"""개인 실행기 경계 검사. Windows 분기는 모의이며 실제 OS 인증이 아니다."""

import asyncio
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch, AsyncMock

from core.runtime import client_platform as files, client_process as processes
from core.client.ai.codex import _execute
from core.client.ai.resume import fixed_selection, completed_results
from core.client.transport import AnalysisClientError
from tools.runtime_doctor import access_match


class FileBoundaryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="wiki-client-platform-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()

    def test_private_create_read_existing_preserved_links_rejected(self):
        path = self.root / "token"
        files.write_new(path, b"private")
        self.assertEqual(files.read_private(path, 8), b"private")
        with self.assertRaises(FileExistsError):
            files.write_new(path, b"replace")
        link = self.root / "linked"
        link.symlink_to(path)
        with self.assertRaises(OSError):
            files.read_private(link, 8)
        path.chmod(0o644)
        with self.assertRaises(OSError):
            files.read_private(path, 8)
        self.assertEqual(path.read_bytes(), b"private")

    def test_windows_acl_rejects_everyone_null_and_unknown_ace(self):
        class ACL:
            def __init__(self, rows): self.rows = rows
            def GetAceCount(self): return len(self.rows)
            def GetAce(self, index): return self.rows[index]
        class SD:
            def GetSecurityDescriptorOwner(self): return "owner"
            def GetSecurityDescriptorDacl(self): return acl
        security = SimpleNamespace(SE_FILE_OBJECT=1, OWNER_SECURITY_INFORMATION=1,
            DACL_SECURITY_INFORMATION=4, ACCESS_ALLOWED_ACE_TYPE=0, ACCESS_DENIED_ACE_TYPE=1,
            ConvertSidToStringSid=lambda value:value, GetSecurityInfo=lambda *args:SD())
        with patch.object(files, '_win', return_value=(None,None,None,security,None)), patch.object(files, '_sid', return_value='owner'):
            for acl in (None, ACL([((0,0),1,'everyone')]), ACL([((5,0),1,'owner')])):
                with self.assertRaises(files.ClientPlatformError): files._check_acl(object())
            acl = ACL([((0,0),1,'owner'),((0,0),1,'S-1-5-18')])
            files._check_acl(object())

    def test_windows_npm_resolution_uses_node_without_shell(self):
        script = self.root / 'node_modules/@openai/codex/bin/codex.js'
        script.parent.mkdir(parents=True)
        script.write_text('fixture')
        with patch.object(processes, 'is_windows', return_value=True), patch.object(processes.shutil, 'which', side_effect=[str(self.root/'codex.cmd'),'node.exe']):
            self.assertEqual(processes.cli_command('codex'), ['node.exe',str(script)])
        with patch.object(processes, 'is_windows', return_value=True), patch.object(processes.shutil, 'which', return_value=str(self.root/'arbitrary.cmd')):
            with self.assertRaises(files.ClientPlatformError): processes.cli_command('arbitrary.cmd')
        with patch.object(files, 'is_windows', return_value=True):
            self.assertEqual(files.project_python(self.root), self.root/'.venv/Scripts/python.exe')

    def test_bootstrap_waits_for_parent_job_gate(self):
        marker = self.root/'child'
        process = subprocess.Popen([sys.executable,'-B',str(Path(processes.__file__).with_name('windows_cli_bootstrap.py')),'--',sys.executable,'-c',
            'import pathlib,sys; pathlib.Path(sys.argv[1]).write_text(sys.stdin.read())',str(marker)],stdin=subprocess.PIPE)
        # EOF without the launch gate exits before creating any child.
        process.communicate(b'',timeout=10)
        self.assertEqual(process.returncode,2)
        self.assertFalse(marker.exists())
        process = subprocess.Popen([sys.executable,'-B',str(Path(processes.__file__).with_name('windows_cli_bootstrap.py')),'--',sys.executable,'-c',
            'import pathlib,sys; pathlib.Path(sys.argv[1]).write_text(sys.stdin.read())',str(marker)],stdin=subprocess.PIPE)
        process.communicate(b'\0payload',timeout=10)
        self.assertEqual(process.returncode,0)
        self.assertEqual(marker.read_text(),'payload')

    def test_access_match_does_not_claim_backend_identity(self):
        access = {'user_id':'alice','policy_revision':'fixed','memberships':{'alpha':{'profiles':{'all':{}},'permissions':['read']}}}
        self.assertEqual(access_match(access,access,'alpha','all')['backend_identity'],'not_available')
        self.assertEqual(access_match(access,access,'alpha','absent')['code'],'profile_denied')
        self.assertEqual(access_match(access,{**access,'user_id':'bob'})['code'],'api_mcp_access_mismatch')


class RuntimeAsyncTests(unittest.IsolatedAsyncioTestCase):
    async def test_preview_arrives_before_exit_and_hides_reasoning(self):
        temporary=tempfile.TemporaryDirectory(prefix='wiki-preview-'); self.addCleanup(temporary.cleanup)
        seen=[]; event=asyncio.Event()
        def receive(value): seen.append(value); event.set()
        script="import json,time; print(json.dumps({'type':'item.updated','item':{'type':'reasoning','text':'hidden'}}),flush=True); print(json.dumps({'type':'item.updated','item':{'type':'agent_message','text':'answer'}}),flush=True); time.sleep(0.5)"
        task=asyncio.create_task(_execute([sys.executable,'-c',script],directory=temporary.name,environment=dict(os.environ),on_event=receive))
        await asyncio.wait_for(event.wait(),5)
        self.assertFalse(task.done())
        await task
        self.assertEqual(seen,[{'type':'agent_message','text':'answer','event':'item.updated','item_id':None}])

    async def test_callback_cancel_reaps_process(self):
        def cancel(value): raise asyncio.CancelledError()
        with self.assertRaises(asyncio.CancelledError):
            await _execute([sys.executable,'-c',"import json,time; print(json.dumps({'type':'item.updated','item':{'type':'agent_message','text':'preview'}}),flush=True); time.sleep(30)"],directory=None,environment=dict(os.environ),on_event=cancel)

    async def test_resume_blocks_pending_and_changed_outputs(self):
        job={'job_id':'job','job_revision':'current','analysis_basis_ref':{'revision':'basis','profile':{'profile_id':'all'},'context_documents':[],'ruleset_ref':{}},'result_summary':{'results':[{'request_id':'r','state':'pending_reconcile','saved':None}]}}
        with self.assertRaises(AnalysisClientError): await completed_results(None,tenant='alpha',job=job,profile='all')
        job['result_summary']['results']=[{'request_id':'r','state':'complete','saved':True,'basis_current':True,'document':'a.md','stage':'prepare_wiki'}]
        result={'job_revision':'current','state':'complete','saved':True,'receipt':{'document':'a.md','analysis_basis_revision':'basis'},'current_output':{'status':'changed'}}
        with patch('core.client.ai.resume.tool_call',AsyncMock(return_value=result)):
            with self.assertRaises(AnalysisClientError): await completed_results(None,tenant='alpha',job=job,profile='all')
            result['current_output']['status']='current'
            stages, receipts=await completed_results(None,tenant='alpha',job=job,profile='all')
            self.assertEqual(stages,{('a.md','prepare_wiki')})
        self.assertEqual(fixed_selection(job,None,None),('all',[],{}))
        with self.assertRaises(AnalysisClientError): fixed_selection(job,'different',None)


class SetupTests(unittest.TestCase):
    def test_install_lock_and_existing_environment_preserved_on_failure(self):
        from tools import setup_runtime
        temporary=tempfile.TemporaryDirectory(prefix='wiki-setup-');self.addCleanup(temporary.cleanup)
        root=Path(temporary.name)
        (root/'requirements.lock').write_text('fixture==1\n')
        python=files.project_python(root);python.parent.mkdir(parents=True)
        python.write_text('fixture');(root/'.venv/pyvenv.cfg').write_text('home = fixture')
        with patch.object(setup_runtime,'PROJECT_DIR',root), patch.object(setup_runtime.subprocess,'run',side_effect=subprocess.CalledProcessError(1,['fixture'])):
            with self.assertRaises(subprocess.CalledProcessError): setup_runtime.install(role='personal')
            self.assertEqual(python.read_text(),'fixture')
            self.assertFalse((root/'.runtime-install.lock').exists())
        (root/'.runtime-install.lock').write_text('other owner')
        with patch.object(setup_runtime,'PROJECT_DIR',root):
            with self.assertRaises(FileExistsError): setup_runtime.install(role='personal')
        self.assertEqual((root/'.runtime-install.lock').read_text(),'other owner')

    def test_token_setup_never_replaces_existing_file(self):
        from tools import protect_client_token
        import io
        temporary=tempfile.TemporaryDirectory(prefix='wiki-token-');self.addCleanup(temporary.cleanup)
        path=Path(temporary.name)/'token';path.write_text('existing')
        with patch.object(sys,'stdout',io.StringIO()) as out, patch.object(protect_client_token.getpass,'getpass',side_effect=AssertionError('must not prompt')):
            code=protect_client_token.main(['--token-file',str(path)])
            self.assertEqual(code,1)
            self.assertEqual(json.loads(out.getvalue())['error']['code'],'existing_token_preserved')
        self.assertEqual(path.read_text(),'existing')


if __name__=='__main__': unittest.main()
