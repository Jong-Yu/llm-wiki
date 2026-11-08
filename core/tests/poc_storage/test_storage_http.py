"""Storage contracts through the real authenticated API, with isolated data."""
from hashlib import sha256
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

from fastapi.testclient import TestClient
from core.modules.access.policy import AccessPolicy
from core.modules.documents import changes
from core.runtime.application import create_application
from tools.initialize_server import initialize_new_server


class StorageHTTP(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        paths = initialize_new_server(Path(tmp.name).resolve() / 'server')
        self.config = Path(paths['access_config'])
        self.policy = AccessPolicy(self.config, Path(paths['tenant_root']))
        self.client = self.enterContext(TestClient(create_application(self.policy), base_url='http://127.0.0.1:8766'))
        response = self.client.post('/api/v1/auth/signup',json={'name':'저장 사용자'})
        self.assertEqual(response.status_code,200,response.text)
        self.user = response.json()['data']
        self.headers = {'Authorization':'Bearer '+self.user['token']}
        self.prefix = '/api/v1/tenants/'+self.user['default_tenant']

    def save(self, content, revision=None, **kw):
        return self.client.put(self.prefix+'/documents/content',headers=self.headers,
            json={'document':'example.md','content':content,'expected_revision':revision,**kw})

    def read(self):
        response = self.client.get(self.prefix+'/documents/content',headers=self.headers,params={'document':'example.md'})
        self.assertEqual(response.status_code,200,response.text)
        return response.json()['data']

    def test_authenticated_metadata_history_and_full_file_cas(self):
        response = self.save('# 본문\r\n원문\r\n',reason='직접 작성')
        self.assertEqual(response.status_code,200,response.text)
        first = self.read()
        self.assertEqual(first['body'],'# 본문\r\n원문\r\n')
        self.assertEqual(first['revision'],sha256(first['content'].encode()).hexdigest())
        self.assertEqual(first['authorship']['created']['actor']['user_id'],self.user['user_id'])
        self.assertEqual(first['authorship']['created']['origin'],{'kind':'human'})
        changed = first['content'].replace('title: "example"','title: "편집 제목"').replace('tags: []','tags: ["한글"]')
        response = self.save(changed,first['revision'],reason='설명 수정')
        self.assertEqual(response.status_code,200,response.text)
        second = self.read()
        self.assertEqual(second['body_revision'],first['body_revision'])
        self.assertNotEqual(second['revision'],first['revision'])
        self.assertEqual(second['metadata']['tags'],['한글'])
        self.assertEqual(self.save(changed,first['revision']).status_code,409)
        versions = self.client.get(self.prefix+'/documents/versions',headers=self.headers,params={'document':'example.md'}).json()['data']
        self.assertTrue(versions['complete'])
        self.assertEqual(len(versions['items']),1)
        old = self.client.get(self.prefix+'/documents/versions/'+versions['items'][0]['history_id'],headers=self.headers,
            params={'document':'example.md'}).json()['data']
        self.assertEqual(old['content'],first['content'])
        listed = self.client.get(self.prefix+'/documents',headers=self.headers).json()['data']['items'][0]
        self.assertEqual(listed['metadata']['title'],'편집 제목')
        self.assertEqual(listed['authorship']['updated']['reason'],'설명 수정')

    def test_forged_actor_managed_identity_and_revoked_write_are_rejected(self):
        self.assertEqual(self.save('new',actor={'user_id':'someone'}).status_code,422)
        self.assertEqual(self.save('new').status_code,200)
        first = self.read()
        forged = first['content'].replace(first['document_id'],uuid4().hex)
        self.assertEqual(self.save(forged,first['revision']).status_code,422)
        policy = json.loads(self.config.read_text())
        policy['users'][self.user['user_id']]['memberships'][self.user['default_tenant']]['permissions']=['read']
        self.config.write_text(json.dumps(policy))
        self.assertEqual(self.save(first['content'],first['revision']).status_code,403)
        self.assertEqual(self.read()['content'],first['content'])

    def test_original_bytes_versions_and_personal_api_isolation(self):
        request = {'request_id':uuid4().hex,'title':'원본','format':'txt','content':'보존\r\n'}
        result = self.client.post(self.prefix+'/sources',headers=self.headers,json=request)
        self.assertEqual(result.status_code,201,result.text)
        source = result.json()['data']
        original = self.client.get(self.prefix+'/sources/'+source['source_id']+'/versions/'+source['source_version']+'/file',headers=self.headers)
        self.assertEqual(original.content,'보존\r\n'.encode())
        response = self.client.post(self.prefix+'/conversations',headers=self.headers,json={'request_id':uuid4().hex,'title':'개인 대화'})
        self.assertEqual(response.status_code,201,response.text)
        record_id = response.json()['data']['record']['id']
        bob = self.client.post('/api/v1/auth/signup',json={'name':'다른 사용자'}).json()['data']
        other = {'Authorization':'Bearer '+bob['token']}
        self.assertEqual(self.client.get(self.prefix+'/conversations/'+record_id,headers=other).status_code,404)
        self.assertEqual(self.client.get(self.prefix+'/conversations',headers=other).json()['data']['items'],[])
        self.assertEqual(self.client.get(self.prefix+'/conversations/'+record_id,headers=self.headers).status_code,200)

    def test_audit_finalize_failure_returns_committed_document_receipt(self):
        with patch.object(changes,'finish',side_effect=OSError('audit full')):
            response = self.save('body')
        self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(response.json()['data']['audit_status'],'pending_reconcile')
        first = self.read()
        self.assertEqual(first['body'],'body')
        self.assertEqual(first['authorship']['status'],'pending_reconcile')
        response = self.save(first['content'],first['revision'])
        self.assertEqual(response.status_code,200,response.text)
        self.assertFalse(response.json()['data']['changed'])
        self.assertEqual(self.read()['authorship']['status'],'recorded')


if __name__ == '__main__': unittest.main()
