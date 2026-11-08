"""보호된 로컬 세션 기록만 수동 재대조의 CLI 재개에 사용할 수 있다."""
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch
from uuid import uuid4

from core.client.ai.claude import ClaudeAdapter
from core.client.comparison_restart import restart_comparison
from core.client.session_refs import SessionRefs, binding, registry_path
from core.client.transport import AnalysisClientError
from core.runtime.client_platform import private_directory


class SessionReferenceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.origin = private_directory(self.root / 'original-invocation')
        self.refs = SessionRefs(self.root / 'ai-session-refs')
        self.session = str(uuid4())
        self.scope = binding(server='http://127.0.0.1:8766/', tenant='fixture', user_id='owner',
                             profile='view', document='pump.md', job_id=uuid4().hex)
        self.execution = {'provider':'claude', 'session_id':self.session, 'session_persisted':True,
                          'session_directory':str(self.origin)}

    def remember(self):
        return self.refs.remember(scope=self.scope, execution=self.execution, invocation=self.origin)

    def record(self):
        return {'record': {'id':uuid4().hex, 'tenant':self.scope['tenant'], 'user_id':self.scope['user_id'],
            'actor':{'profile_id':self.scope['profile']}, 'data':{
                'provider':'claude','session_id':self.session,'document':self.scope['document'],
                'job_id':self.scope['job_id']}}}

    async def restart(self, adapter, *, previous=None):
        previous = previous or self.record()
        with patch('core.client.comparison_restart._call', new=AsyncMock(side_effect=[
                previous, {'source_revision':'source', 'graph_revision':'graph'}])):
            return await restart_comparison(base_url=self.scope['server'], tenant=self.scope['tenant'],
                token='not-transmitted', comparison_id=previous['record']['id'], request_id=uuid4().hex,
                work_dir=self.root/'work', adapter=adapter, provider='claude', profile=self.scope['profile'],
                session_registry=self.refs.directory, http=object())

    def test_private_immutable_record_and_cli_default(self):
        expected = self.remember()
        record_file = next(self.refs.directory.glob('*.json'))
        before = record_file.read_bytes()
        self.assertEqual(self.remember(), expected)
        self.assertEqual(self.refs.resolve(scope=self.scope,provider='claude',session_id=self.session), expected)
        self.assertEqual(registry_path(self.root), self.root/'ai-session-refs')
        self.assertEqual(registry_path(self.root,self.refs.directory),self.refs.directory)
        changed = {**self.scope,'document':'other.md'}
        with self.assertRaises(AnalysisClientError) as mismatch:
            self.refs.remember(scope=changed,execution=self.execution,invocation=self.origin)
        self.assertEqual(mismatch.exception.code,'comparison_session_binding_mismatch')
        self.assertEqual(record_file.read_bytes(),before)
        self.assertFalse(list(self.refs.directory.glob('.*.part')))
        if os.name != 'nt':
            self.assertEqual(record_file.stat().st_mode & 0o777,0o600)
            self.assertEqual(self.refs.directory.stat().st_mode & 0o777,0o700)

    def test_every_binding_component_must_match(self):
        self.remember()
        for key, value in {'server':'https://other.example','tenant':'other','user_id':'other',
                           'profile':'other','document':'other.md','job_id':uuid4().hex}.items():
            with self.subTest(key=key), self.assertRaises(AnalysisClientError) as caught:
                self.refs.resolve(scope={**self.scope,key:value},provider='claude',session_id=self.session)
            self.assertEqual(caught.exception.code,'comparison_session_binding_mismatch')
        for provider, session in [('codex',self.session),('claude',str(uuid4()))]:
            with self.assertRaises(AnalysisClientError) as caught:
                self.refs.resolve(scope=self.scope,provider=provider,session_id=session)
            self.assertEqual(caught.exception.code,'comparison_session_ref_unknown')

    def test_concurrent_conflicting_binding_keeps_one_immutable_record(self):
        private_directory(self.refs.directory)
        def publish(document):
            try:
                return self.refs.remember(scope={**self.scope,'document':document},
                    execution=self.execution,invocation=self.origin)
            except AnalysisClientError:
                return None
        with ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(publish,['one.md','two.md']))
        winners=[item for item in results if item is not None]
        self.assertEqual(len(winners),1)
        stored=json.loads(next(self.refs.directory.glob('*.json')).read_text())
        self.assertEqual(stored,winners[0])
        self.assertEqual(len(list(self.refs.directory.glob('*.json'))),1)
        self.assertFalse(list(self.refs.directory.glob('.*.part')))

    def test_unobserved_or_missing_claude_cwd_is_not_guessed(self):
        for changes in [{'session_persisted':False},{'session_directory':None},{'session_id':'bad'}]:
            with self.subTest(changes=changes), self.assertRaises(AnalysisClientError):
                self.refs.remember(scope=self.scope,execution={**self.execution,**changes},invocation=self.origin)
        self.assertFalse(self.refs.directory.exists())

    @unittest.skipIf(os.name == 'nt','POSIX mode/symlink behavior is tested here; Windows uses DACL checks.')
    def test_public_replaced_symlink_and_missing_paths_are_rejected(self):
        self.remember()
        record_file=next(self.refs.directory.glob('*.json'))
        record_file.chmod(0o644)
        with self.assertRaises(AnalysisClientError):
            self.refs.resolve(scope=self.scope,provider='claude',session_id=self.session)
        record_file.chmod(0o600)
        saved=record_file.with_suffix('.saved')
        record_file.rename(saved)
        record_file.symlink_to(saved)
        with self.assertRaises(AnalysisClientError):
            self.refs.resolve(scope=self.scope,provider='claude',session_id=self.session)
        record_file.unlink();saved.rename(record_file)
        self.origin.rmdir()
        with self.assertRaises(AnalysisClientError) as missing:
            self.refs.resolve(scope=self.scope,provider='claude',session_id=self.session)
        self.assertEqual(missing.exception.code,'comparison_session_directory_unavailable')
        self.assertFalse(self.origin.exists())

    async def test_unknown_and_mismatched_server_record_fail_before_preflight_or_model(self):
        adapter=SimpleNamespace(preflight=AsyncMock(),run=AsyncMock())
        with self.assertRaises(AnalysisClientError) as unknown:
            await self.restart(adapter)
        self.assertEqual(unknown.exception.code,'comparison_session_ref_unknown')
        self.remember()
        previous=self.record();previous['record']['data']['document']='other.md'
        with self.assertRaises(AnalysisClientError) as mismatch:
            await self.restart(adapter,previous=previous)
        self.assertEqual(mismatch.exception.code,'comparison_session_binding_mismatch')
        adapter.preflight.assert_not_awaited();adapter.run.assert_not_awaited()
        self.assertFalse(hasattr(adapter,'_session_directory'))

    async def test_new_claude_adapter_restores_trusted_original_cwd(self):
        self.remember()
        adapter=ClaudeAdapter()
        adapter._capabilities=(['claude'],'fixture')
        calls=[]
        async def execute(arguments,**kwargs):
            calls.append((arguments,kwargs['directory']))
            event={'type':'result','subtype':'success','is_error':False,'session_id':self.session,
                   'structured_output':{'answer':'continued'}}
            kwargs['event_parser'](json.dumps(event).encode(),lambda _:None)
            return 0,json.dumps(event).encode(),b''
        async def compare(http, continuation, **kwargs):
            result=await continuation(prompt='Recall',output_schema={'type':'object',
                'properties':{'answer':{'type':'string'}},'required':['answer'],'additionalProperties':False},
                directory=self.root/'new-output')
            self.assertEqual(result['execution']['session_directory'],str(self.origin))
            return {'record':{'id':uuid4().hex},'status':'complete','lookup_count':1}
        self.assertFalse(hasattr(adapter,'_session_directory'))
        with patch('core.client.ai.claude._execute',execute), \
                patch('core.client.comparison_restart.run_comparison',compare):
            result=await self.restart(adapter)
        self.assertEqual(result['status'],'complete')
        self.assertEqual(len(calls),1)
        self.assertEqual(calls[0][1],self.origin)
        self.assertEqual(calls[0][0][calls[0][0].index('--resume')+1],self.session)
        self.assertTrue((self.root/'new-output'/'result.json').is_file())


if __name__=='__main__':
    unittest.main()
