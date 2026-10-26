"""Actual authenticated stdio/HTTP schema5 on temporary synthetic tenants."""
from copy import deepcopy
import unittest
from core.tests.mcp import test_anchor_mcp as transport
from core.tests.mcp import test_tenant_mcp as tenant
from core.tests.modules import test_schema5_ontology as fixtures

class Schema5StdioTests(unittest.IsolatedAsyncioTestCase):
    save_policy=tenant.TenantMCPTests.save_policy
    payload=tenant.TenantMCPTests.payload
    snapshot=tenant.TenantMCPTests.snapshot
    write=tenant.TenantMCPTests.write
    http_server=tenant.TenantMCPTests.http_server
    http_client=tenant.TenantMCPTests.http_client
    client=transport.AnchorStdioTests.client
    def setUp(self):
        tenant.TenantMCPTests.setUp(self)
        self.config['users']['alice']['memberships']['acme']['permissions'].append('ontology_review')
        self.save_policy()
    async def seed(self,client):
        saved=self.payload(await self.write(client,fixtures.SOURCE,document=fixtures.DOCUMENT))
        args=fixtures.request(saved['revision']);args['tenant']='acme';return saved,args
    async def query(self,client):return self.payload(await client.call_tool('ontology_review_query',{'tenant':'acme','document':fixtures.DOCUMENT,'profile':'all'}))
    async def test_actual_stdio5_roundtrip_mapping_review_and_consumers(self):
        policy_before=self.config_path.read_bytes()
        async with self.client() as c:
            tool=next(t for t in (await c.list_tools()).tools if t.name=='ontology_generate');self.assertEqual(tool.input_schema['properties']['schema_version']['enum'],[3,4,5,6]);self.assertEqual(tool.input_schema['properties']['schema_version']['default'],3)
            saved,args=await self.seed(c);self.payload(await c.call_tool('ontology_generate',args));q=await self.query(c)
            self.assertEqual(q['machine_graph']['schema_version'],5);self.assertEqual(q['claims'][0]['value']['mapping'],args['relations'][0]['mapping']);self.assertTrue(all(x['decision']=='unreviewed' for x in q['claims']))
            accepted=self.payload(await c.call_tool('ontology_review',{'tenant':'acme','document':fixtures.DOCUMENT,'profile':'all','action':'accept','claim_id':q['claims'][0]['claim_id'],'expected_state_revision':q['state_revision'],'reason':'Synthetic simulation, not actual human approval'}))
            self.assertEqual(accepted['effective_graph']['relations'][0]['mapping'],args['relations'][0]['mapping'])
            again=await self.query(c);self.assertEqual(again['history'],accepted['history'])
            ctx=self.payload(await c.call_tool('ontology_context',{'tenant':'acme','documents':[fixtures.DOCUMENT],'profile':'all'}));self.assertTrue(ctx['complete']);self.assertEqual(ctx['documents'][0]['ontology']['relations'][0]['mapping'],args['relations'][0]['mapping'])
            found=self.payload(await c.call_tool('ontology_concept_find',{'tenant':'acme','text':'campaign','documents':[fixtures.DOCUMENT],'profile':'all','limit':100}));target=next(m['target_ref'] for m in found['matches'] if m['target_ref'].get('kind')=='document_claim' and m['target_ref']['layer']=='machine')
            detail=self.payload(await c.call_tool('ontology_concept_query',{'tenant':'acme','target':target,'documents':[fixtures.DOCUMENT],'profile':'all'}));self.assertTrue(detail['complete']);self.assertEqual(detail['documents'][0]['machine_graph']['relations'][0]['mapping'],args['relations'][0]['mapping'])
        self.assertEqual(self.config_path.read_bytes(),policy_before)
    async def test_actual_stdio_strict_versions_and_null_mapping_no_legacy_default(self):
        async with self.client() as c:
            _,args=await self.seed(c);self.payload(await c.call_tool('ontology_generate',args));before=self.snapshot()
            for version in (True,'5',5.0,None,2,7):
                a=deepcopy(args);a['schema_version']=version;self.payload(await c.call_tool('ontology_generate',a),code='invalid_argument')
            for version in (3,4,5):
                a=deepcopy(args);a['schema_version']=version;a['relations']=[{'subject':'package','predicate':'related_to','object':'ship','evidence':fixtures.SOURCE.splitlines()[0],'mapping':None}]
                self.payload(await c.call_tool('ontology_generate',a),code='invalid_ontology')
            for mapping in (None,{}, {'within':'missing','subject_cardinality':'many','object_cardinality':'many'},{'within':'campaign','subject_cardinality':True,'object_cardinality':'many'}):
                a=deepcopy(args);a['relations'][0]['mapping']=mapping;self.assertTrue((await c.call_tool('ontology_generate',a)).is_error)
            self.assertEqual(before,self.snapshot())
            legacy=deepcopy(args);legacy.pop('schema_version');legacy['relations']=[{'subject':'package','predicate':'related_to','object':'ship','evidence':fixtures.SOURCE.splitlines()[0]}]
            self.payload(await c.call_tool('ontology_generate',legacy));q=await self.query(c);self.assertEqual(q['machine_graph']['schema_version'],3);self.assertNotIn('mapping',q['machine_graph']['relations'][0])
    async def test_actual_stdio5_read_only_denial_stale_and_full_source_history(self):
        policy_before=self.config_path.read_bytes()
        async with self.client() as alice,self.client('bob') as bob:
            saved,args=await self.seed(alice);self.payload(await alice.call_tool('ontology_generate',args));before=self.snapshot()
            self.payload(await bob.call_tool('ontology_generate',args),code='access_denied');self.assertEqual(before,self.snapshot())
            changed=self.payload(await self.write(alice,fixtures.SOURCE+'추가 원문.\n',document=fixtures.DOCUMENT,revision=saved['revision']))
            stale=self.payload(await alice.call_tool('ontology_query',{'tenant':'acme','document':fixtures.DOCUMENT,'profile':'all'}));self.assertEqual(stale['status'],'stale');self.assertEqual(stale['relations'],[])
            self.payload(await alice.call_tool('ontology_generate',args),code='conflict');args['expected_revision']=changed['revision'];self.payload(await alice.call_tool('ontology_generate',args),code='invalid_ontology')
            self.assertEqual((self.stores['acme'].data_dir/changed['history_path']).read_bytes(),fixtures.SOURCE.encode())
        self.assertEqual(policy_before,self.config_path.read_bytes())
    async def test_actual_authenticated_http5_mapping_unreviewed_policy_and_source(self):
        policy_before=self.config_path.read_bytes()
        async with self.http_server() as url:
            async with self.http_client(url,mode='auto') as c:
                context=self.payload(await c.call_tool('access_context',{}));self.assertEqual(context['user_id'],'alice')
                saved,args=await self.seed(c);self.payload(await c.call_tool('ontology_generate',args));q=await self.query(c)
                self.assertEqual(q['machine_graph']['schema_version'],5);self.assertEqual(q['machine_graph']['relations'][0]['mapping'],args['relations'][0]['mapping']);self.assertEqual(q['history'],[]);self.assertTrue(all(x['decision']=='unreviewed' for x in q['claims']))
                source=self.payload(await c.call_tool('wiki_read',{'tenant':'acme','document':fixtures.DOCUMENT}));self.assertEqual(source['content'],fixtures.SOURCE);self.assertEqual(source['revision'],saved['revision'])
        self.assertEqual(policy_before,self.config_path.read_bytes())

if __name__=='__main__':unittest.main()
