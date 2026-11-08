"""등록·추출 저장·같은 대화 대조·수동 재실행을 실제 격리 API에 연결한다."""
from copy import deepcopy
from hashlib import sha256
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from uuid import uuid4
import httpx2

from core.common.json_codec import canonical_json_bytes
from core.client.analysis import prepare
from core.client.comparison_restart import restart_comparison
from core.client.session_refs import SessionRefs, binding
from core.client.transport import AnalysisClientError
from core.modules.access.policy import AccessPolicy
from core.modules.access.auth import initialize_auth
from core.modules.extraction_rules.publish import publish
from core.modules.extraction_rules.store import RulesetRegistry
from core.modules.analysis_results.diagnostics import empty_report
from core.modules.ontology.store import OntologyStore
from core.modules.personal.comparisons import ComparisonStore
from core.runtime.application import create_application
from core.runtime.extraction_schema import build_submission_schema
from core.tests.poc_knowledge.test_storage import ENTITIES, RELATIONS


class ContinuedFixtureAdapter:
    """실제 모델을 흉내 낸 연결 시험이며 의미 품질의 증거로 사용하지 않는다."""
    def __init__(self):
        self.persist_session=False
        self.session_id=str(uuid4())
        self.extractions=0
        self.continuations=[]

    async def preflight(self):
        return {'provider':'codex','cli_version':'fixture'}

    async def run(self, *, prompt, schema, directory, output_schema=None, session_id=None):
        if session_id is None:
            self.extractions+=1
            value={'submission':{'schema_version':3,'entities':deepcopy(ENTITIES),
                'relations':[],'relation_candidates':[],'attributes':[]},'diagnostics':empty_report()}
        else:
            assert session_id==self.session_id
            self.continuations.append(json.loads(prompt.split('\n',1)[1]))
            value={'action':'finish','terms':[],'reference_id':None,'status':'complete',
                'candidates':[],'excluded':[],'unconfirmed':['Synthetic integration test only']}
        return {'value':value,'execution':{'provider':'codex','cli_version':'fixture','session_id':self.session_id,
            'session_persisted':True,'prompt_sha256':sha256(prompt.encode()).hexdigest(),
            'schema_sha256':sha256(canonical_json_bytes(schema)).hexdigest(),
            'output_sha256':sha256(canonical_json_bytes(value)).hexdigest()}}


class PostExtractionTests(unittest.IsolatedAsyncioTestCase):
    async def test_stored_extraction_continues_and_manual_restart_does_not_extract(self):
        with TemporaryDirectory() as temp:
            root=Path(temp).resolve();(root/'data').mkdir();(root/'tenancy').mkdir()
            config=root/'tenancy/policy.json';config.write_text(json.dumps({'version':1,'tenants':{},'users':{}}))
            policy=AccessPolicy(config,root/'data');auth=initialize_auth(policy);user=auth.signup('continuation fixture')
            tenant=user['default_tenant'];scope=policy.authorize(user['token'],tenant,'read')
            scope.store.save('existing.md','A uses B.\n',expected_revision=None)
            OntologyStore(scope.store).generate('existing.md',scope.store.read('existing.md').revision,
                deepcopy(ENTITIES),deepcopy(RELATIONS))
            schema=build_submission_schema()
            publish(root/'rules',tenant_root=root/'data',ruleset_id='common',ruleset_version='v1',
                reason='isolated continuation integration',schema=schema,expected_schema=schema)
            ref={'ruleset_id':'common','ruleset_version':'v1'}
            (root/'rules-policy.json').write_text(json.dumps({'version':1,'tenants':{tenant:{'default':ref,'allowed':[ref],'revoked':[]}}}))
            rules=RulesetRegistry(root/'rules',root/'rules-policy.json',root/'data',expected_schema=schema)
            app=create_application(policy,auth=auth,rulesets=rules)
            original=httpx2.AsyncClient;transport=httpx2.ASGITransport(app=app);base='http://127.0.0.1:8766'
            def local(*args,**kwargs): return original(*args,transport=transport,**kwargs)
            async with app.router.lifespan_context(app):
                async with original(transport=transport,base_url=base,headers={'Authorization':'Bearer '+user['token']}) as http:
                    response=await http.post(f'/api/v1/tenants/{tenant}/sources',json={'request_id':uuid4().hex,
                        'title':'A uses B','format':'txt','content':'A uses B.\n'})
                    self.assertEqual(response.status_code,201,response.text)
                    source=response.json()['data']
                    response=await http.post(f'/api/v1/tenants/{tenant}/analysis-jobs/registrations',json={
                        'request_id':uuid4().hex,'title':'A uses B','document':'new.md',
                        'source_ref':{key:source[key] for key in ('source_id','source_version','source_sha256','registration_revision')}})
                    self.assertEqual(response.status_code,201,response.text)
                    job=response.json()['data'];adapter=ContinuedFixtureAdapter()
                    session_registry=root/'shared-session-refs'
                    with patch('core.client.analysis.httpx2.AsyncClient',side_effect=local):
                        result=await prepare(base_url=base,tenant=tenant,job_id=job['job_id'],token=user['token'],
                            work_dir=root/'work',adapter=adapter,session_registry=session_registry)
                    self.assertEqual(result['ai_execution']['status'],'stored')
                    comparison=result['ai_execution']['comparison']
                    self.assertEqual(comparison['status'],'complete',comparison)
                    self.assertEqual(adapter.extractions,1)
                    self.assertNotIn('session_ref_error',comparison)
                    first=ComparisonStore(scope).read(comparison['comparison_id'])
                    local_ref=SessionRefs(session_registry).resolve(scope=binding(server=base,tenant=tenant,
                        user_id=user['user_id'],profile=scope.profile_id,document='new.md',job_id=job['job_id']),
                        provider='codex',session_id=adapter.session_id)
                    self.assertTrue(Path(local_ref['session_directory']).is_dir())
                    with self.assertRaises(AnalysisClientError) as missing:
                        await restart_comparison(base_url=base,tenant=tenant,token=user['token'],
                            comparison_id=comparison['comparison_id'],request_id=uuid4().hex,work_dir=root/'unknown',
                            adapter=adapter,provider='codex',profile=scope.profile_id,http=http)
                    self.assertEqual(missing.exception.code,'comparison_session_ref_unknown')
                    self.assertEqual(len(adapter.continuations),1)
                    request_id=uuid4().hex
                    restarted=await restart_comparison(base_url=base,tenant=tenant,token=user['token'],
                        comparison_id=comparison['comparison_id'],request_id=request_id,work_dir=root/'retry',
                        adapter=adapter,provider='codex',profile=scope.profile_id,http=http,session_registry=session_registry)
                    self.assertEqual(restarted['status'],'complete')
                    self.assertNotEqual(restarted['comparison_id'],comparison['comparison_id'])
                    self.assertEqual(adapter.extractions,1)
                    self.assertEqual(len(adapter.continuations),2)
                    self.assertIn('current_target_input',adapter.continuations[-1])
                    self.assertEqual(ComparisonStore(scope).read(comparison['comparison_id'])['record'],first['record'])
                    # 같은 접수 ID 확인은 모델 호출·조회 예산을 다시 소비하지 않는다.
                    again=await restart_comparison(base_url=base,tenant=tenant,token=user['token'],
                        comparison_id=comparison['comparison_id'],request_id=request_id,work_dir=root/'confirm',
                        adapter=adapter,provider='codex',profile=scope.profile_id,http=http,session_registry=session_registry)
                    self.assertEqual(again['comparison_id'],restarted['comparison_id'])
                    self.assertEqual(len(adapter.continuations),2)


if __name__=='__main__': unittest.main()
