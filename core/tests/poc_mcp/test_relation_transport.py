"""독립 관계 추가의 실제 API 권한·판본·영수증 경계, 모두 격리 모의 자료."""
from copy import deepcopy
from unittest.mock import patch
from uuid import uuid4
from core.tests.poc_mcp.test_server_integration import ServerFixture
from core.tests.poc_knowledge.test_storage import ENTITIES, RELATIONS
from core.modules.ontology.store import OntologyStore
from core.modules.reviews.store import ReviewStore
from core.modules.reviews.values import _input
from core.modules.reviews.relations import RelationStore


class RelationTransportTests(ServerFixture):
    def setUp(self):
        super().setUp()
        self.write('A uses B.\nB depends on A.\n')
        self.scope=self.policy.authorize(self.token,self.tenant,'ontology_review')
        self.store=self.scope.store
        self.reviews=ReviewStore(self.store)
        OntologyStore(self.store).generate('example.md',self.store.read('example.md').revision,deepcopy(ENTITIES),deepcopy(RELATIONS))
        self.prefix=f'/api/v1/tenants/{self.tenant}/documents'

    def payload(self, kind='source'):
        state=self.reviews.query('example.md')
        value=_input(state['machine_graph']['relations'][0])
        value.update(subject='b',predicate='depends_on',object='a')
        if kind=='source': value['evidence']='B depends on A.'
        else: value.pop('evidence');value.pop('provenance')
        return dict(document='example.md',kind=kind,replacement=value,request_id=uuid4().hex,expected_state_revision=state['state_revision'],reason='simulation')

    def post(self,path,payload):
        return self.client.post(self.prefix+path,headers=self.headers(),json=payload)

    def test_http_roundtrip_and_receipt_are_actual_saved_values(self):
        payload=self.payload()
        created=self.post('/relations',payload)
        self.assertEqual(created.status_code,200,created.text)
        result=created.json()['data']
        knowledge=self.client.get(self.prefix+'/knowledge',headers=self.headers(),params={'document':'example.md'})
        self.assertEqual(knowledge.status_code,200,knowledge.text)
        data=knowledge.json()['data']
        self.assertEqual(len(data['machine_graph']['relations']),1)
        self.assertEqual(len(data['effective_graph']['relations']),2)
        self.assertEqual(data['relation_history'][0]['actor']['user_id'],self.user['user_id'])
        self.assertEqual(self.post('/relations',payload).json()['data']['event_id'],result['event_id'])
        receipt=self.client.get(self.prefix+'/relation-requests/'+payload['request_id'],headers=self.headers(),params={'document':'example.md'})
        self.assertEqual(receipt.status_code,200,receipt.text)
        undone=self.post('/relation-undos',dict(document='example.md',kind='source',event_id=result['event_id'],request_id=uuid4().hex,expected_state_revision=result['state_revision'],reason='simulation inverse'))
        self.assertEqual(undone.status_code,200,undone.text)
        self.assertEqual(len(self.reviews.query('example.md')['effective_graph']['relations']),1)

    def test_permissions_are_kind_specific_and_tenant_profile_do_not_bypass(self):
        payload=self.payload('policy')
        self.change_policy(lambda value:value['users'][self.user['user_id']]['memberships'][self.tenant].update(permissions=['read','ontology_review']))
        self.assertEqual(self.post('/relations',payload).status_code,403)
        payload=self.payload()
        self.assertEqual(self.post('/relations',{**payload,'profile':'forbidden'}).status_code,403)
        self.assertEqual(self.client.post('/api/v1/tenants/forbidden/documents/relations',headers=self.headers(),json=payload).status_code,403)
        self.change_policy(lambda value:value['users'][self.user['user_id']]['memberships'][self.tenant].update(permissions=['read','ontology_policy']))
        self.assertEqual(self.post('/relations',payload).status_code,403)
        self.assertEqual(self.post('/relations',self.payload('policy')).status_code,200)

    def test_stale_basis_and_injected_actor_are_rejected(self):
        payload=self.payload()
        self.assertEqual(self.post('/relations',{**payload,'actor':{'user_id':'fabricated'}}).status_code,422)
        current=self.store.read('example.md')
        self.store.save('example.md',current.content+'Changed.\n',expected_revision=current.revision)
        self.assertEqual(self.post('/relations',payload).status_code,409)

    def test_reauthorize_at_commit_and_receipt_owner(self):
        payload=self.payload()
        original=RelationStore._mutate
        def revoke(owner,*args,**kwargs):
            self.change_policy(lambda value:value['users'][self.user['user_id']]['memberships'][self.tenant].update(permissions=['read']))
            return original(owner,*args,**kwargs)
        with patch.object(RelationStore,'_mutate',revoke):
            self.assertEqual(self.post('/relations',payload).status_code,403)
        self.assertFalse(self.reviews._path('example.md').exists())
        self.change_policy(lambda value:value['users'][self.user['user_id']]['memberships'][self.tenant].update(permissions=['read','ontology_review']))
        self.assertEqual(self.post('/relations',payload).status_code,200)
        stranger=self.signup('다른 사용자')
        response=self.client.get(self.prefix+'/relation-requests/'+payload['request_id'],headers=self.headers(stranger['token']),params={'document':'example.md'})
        self.assertEqual(response.status_code,404)
